import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, type Task } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { type Envelope, USER } from "../src/hub/envelope.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";

class Quiet extends BasePeer {
  async start() { this.setState("busy"); }
  async stop() { this.setState("offline"); }
  async deliver(_envs: Envelope[]) {}
}
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
async function rig(now?: () => number) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-write-notices-")), board = new Board(join(cwd, "hub.db"));
  const bus = new Bus({ batchMs: 0 }), notices: string[] = [];
  const roles: Record<string, string[]> = { claude: ["planner"], pi: ["planner"], codex: ["implementer"] };
  const tasks = new Tasks({ cwd, board, bus, roles, project: "fixture", routing: () => loadRouting(cwd), notify: line => notices.push(line), ...(now ? { now } : {}) });
  const peers = new Map<string, Quiet>();
  for (const id of Object.keys(roles)) { const peer = new Quiet(id); peers.set(id, peer); bus.add(peer); await peer.start(); }
  cleanup.push(() => { bus.closeJournal(); board.close(); rmSync(cwd, { recursive: true, force: true }); });
  const card = (fields: Partial<Task> = {}) => {
    const made = board.propose(USER, { title: "PRIVATE_TASK_TITLE", detail: "PRIVATE_TASK_DETAIL", class: "implement", backlog: true,
      planner: fields.planner ?? "claude", deps: fields.deps, reserved: fields.reserved ?? undefined, signals: fields.signals });
    const { priority, rank, pinned, release, plannedStart } = fields;
    const patch = Object.fromEntries(Object.entries({ priority, rank, pinned, release, plannedStart }).filter(([, value]) => value !== undefined));
    return Object.keys(patch).length ? board.plan(made.id, USER, patch, 0) : made;
  };
  const owned = (state: Task["state"] = "in_review") => {
    let task = card();
    task = board.update(task.id, USER, "backlog pulled", { state: "proposed", owner: "codex", reviewer: USER });
    task = board.update(task.id, "codex", "accepted", { state: "in_progress" });
    return state === "in_review" ? board.update(task.id, "codex", "done", { state }) : task;
  };
  const pending = (peer = "claude") => bus.pendingEnvelopes(peer).filter(env => env.body.startsWith("Planner work ready:"));
  return { cwd, board, bus, tasks, roles, peers, notices, card, owned, pending };
}

test("AC1: approval wakes the effective planner synchronously with new WIP and top reserved ready id", async () => {
  const r = await rig(), task = r.owned();
  const blocked = r.card({ reserved: "codex", priority: 0, deps: [999] });
  r.card({ reserved: "codex", priority: 0, pinned: true });
  const lower = r.card({ reserved: "codex", priority: 3 });
  const top = r.card({ reserved: "codex", priority: 1 });
  await r.tasks.review(USER, task.id, "approved");
  expect(r.tasks.wip("codex")).toBe(0);
  expect(r.pending()).toHaveLength(1);
  expect(r.pending("pi")).toHaveLength(0);
  expect(r.pending()[0]).toMatchObject({ from: "hub", kind: "task", priority: "status" });
  expect(r.pending()[0]!.body).toContain(`capacity_released: codex WIP 0; reserved ready #${top.id}`);
  expect(r.pending()[0]!.body).not.toContain(`ready #${lower.id}`);
  expect(r.pending()[0]!.body).not.toContain(`ready #${blocked.id}`);
  expect(r.pending()[0]!.body).not.toContain("PRIVATE_TASK");
  expect(r.board.get(top.id)?.state).toBe("backlog"); // notices never pull work
});

test("AC2: only the final dependency approval wakes the backlog card's planner, one pending copy", async () => {
  const r = await rig(), first = r.owned(), last = r.owned();
  const dependent = r.card({ deps: [first.id, last.id], planner: "pi" });
  await r.tasks.review(USER, first.id, "approved");
  expect(r.pending("pi")).toHaveLength(0);
  await r.tasks.review(USER, last.id, "approved");
  expect(r.pending("pi")).toHaveLength(1);
  expect(r.pending("pi")[0]!.body).toContain(`backlog_ready: #${dependent.id}`);
  expect(r.pending("pi")[0]!.body).not.toContain("PRIVATE_TASK");
  expect(r.pending("pi")[0]).toMatchObject({ kind: "task", priority: "status" });
  r.tasks.flushPlannerNotices(); r.tasks.flushPlannerNotices();
  expect(r.pending("pi")).toHaveLength(1);
});

for (const scenario of [
  { name: "before", offset: -1, ready: false },
  { name: "at the boundary", offset: 0, ready: true },
  { name: "after", offset: 1, ready: true },
] as const) test(`dependency approval lists planned work as ready ${scenario.name}`, async () => {
  const plannedStart = 2_000_000_010_000, clock = { now: plannedStart - 1 }, r = await rig(() => clock.now);
  const first = r.owned(), last = r.owned(), dependent = r.card({ deps: [first.id, last.id], planner: "pi", plannedStart });
  await r.tasks.review(USER, first.id, "approved");
  clock.now = plannedStart + scenario.offset;
  await r.tasks.review(USER, last.id, "approved");
  const notice = r.pending("pi")[0]?.body ?? "";
  if (scenario.ready) expect(notice).toContain(`backlog_ready: #${dependent.id}`);
  else expect(notice).not.toContain(`backlog_ready: #${dependent.id}`);
});

for (const operation of ["cancel", "return", "decline", "done"] as const) test(`${operation} emits capacity_released only when WIP falls`, async () => {
  const r = await rig(), task = r.owned("in_progress");
  if (operation === "cancel") await r.tasks.cancel(task.id, USER, { reason: "stop" });
  if (operation === "return") await r.tasks.returnUntouchedToBacklog(USER, { id: task.id, revision: 0, reason: "later" });
  if (operation === "decline") {
    r.roles.pi = ["planner"]; r.roles.claude = ["planner"];
    await r.tasks.decline("codex", task.id, "capacity", true);
  }
  if (operation === "done") { r.board.update(task.id, USER, "fixture no reviewer", { reviewer: null }); await r.tasks.done("codex", task.id, "complete"); }
  expect(r.tasks.wip("codex")).toBe(0);
  expect(r.pending()).toHaveLength(1);
  expect(r.pending()[0]!.body).toContain("capacity_released: codex WIP 0");
});

test("cancel of unowned backlog neither frees capacity nor approves dependencies", async () => {
  const r = await rig(), task = r.card(), dependent = r.card({ deps: [task.id] });
  await r.tasks.cancel(task.id, USER, { reason: "stop" });
  expect(r.pending()).toHaveLength(0);
  expect(r.board.get(dependent.id)?.state).toBe("backlog");
});

test("done awaiting review retains WIP and does not wake the planner", async () => {
  const r = await rig(), task = r.owned("in_progress");
  await r.tasks.done("codex", task.id, "ready for review");
  expect(r.tasks.wip("codex")).toBe(1);
  expect(r.pending()).toHaveLength(0);
});

for (const operation of ["undo", "return"] as const) test(`unowned planner reservation ${operation} releases WIP`, async () => {
  const r = await rig(), task = r.card();
  r.board.pullPlanned(task.id, "claude", "codex", 0, "ready");
  expect(r.tasks.wip("codex")).toBe(1);
  if (operation === "undo") await r.tasks.undoPlanning("claude", task.id, 1);
  else await r.tasks.moveBacklog(USER, task.id, false);
  expect(r.tasks.wip("codex")).toBe(0);
  expect(r.pending()).toHaveLength(1);
  expect(r.pending()[0]!.body).toContain("capacity_released: codex WIP 0");
});

test("PII wake-ups disclose only ids and counts to an offline effective planner", async () => {
  const r = await rig(), task = r.owned();
  r.board.update(task.id, USER, "fixture privacy", { signals: ["pii"] });
  const card = r.card({ deps: [task.id], signals: ["pii"], planner: "pi" });
  await r.peers.get("pi")!.stop();
  await r.tasks.review(USER, task.id, "approved");
  expect(r.pending("pi")).toHaveLength(1);
  expect(r.pending("pi")[0]!.body).toContain(`backlog_ready: #${card.id}`);
  for (const env of [...r.pending(), ...r.pending("pi")]) {
    expect(env.body).not.toContain("PRIVATE_TASK");
    expect(env.refs).toBeUndefined();
  }
});

test("a consumed notice permits a fresh wake-up on the next capacity release", async () => {
  const r = await rig(), first = r.owned(), last = r.owned();
  await r.tasks.review(USER, first.id, "approved");
  r.bus.withdraw(r.pending()[0]!.id);
  await r.tasks.review(USER, last.id, "approved");
  expect(r.pending()).toHaveLength(1);
  expect(r.pending()[0]!.body).toContain("capacity_released: codex WIP 0");
});

test("unsettled capacity and dependency wake-ups coalesce per planner and retain both events", async () => {
  const r = await rig(), first = r.owned(), last = r.owned();
  const a = r.card({ deps: [first.id] }), b = r.card({ deps: [last.id] });
  await r.tasks.review(USER, first.id, "approved");
  await r.tasks.review(USER, last.id, "approved");
  expect(r.pending()).toHaveLength(1);
  const body = r.pending()[0]!.body;
  expect(body).toContain("capacity_released: codex WIP 0");
  expect(body).toContain(`backlog_ready: #${a.id}`);
  expect(body).toContain(`backlog_ready: #${b.id}`);
});

test("post-write publication failure preserves approval and reports lost notice", async () => {
  const r = await rig(), task = r.owned();
  r.bus.publish = () => { throw new Error("fixture unavailable"); };
  expect((await r.tasks.review(USER, task.id, "approved")).state).toBe("approved");
  expect(r.notices.some(line => line.includes("planner") && line.includes("fixture unavailable"))).toBe(true);
});

test("a fresh Tasks preserves every unsettled capacity and backlog event across restart", async () => {
  const r = await rig(), first = r.owned(), second = r.owned();
  r.board.update(second.id, USER, "fixture second owner", { owner: "pi" });
  const a = r.card({ deps: [first.id] }), b = r.card({ deps: [second.id] });
  await r.tasks.review(USER, first.id, "approved");
  expect(r.pending()[0]!.body).toContain(`backlog_ready: #${a.id}`);
  const restarted = new Tasks({ cwd: r.cwd, board: r.board, bus: r.bus, roles: r.roles, project: "fixture",
    routing: () => loadRouting(r.cwd), notify: line => r.notices.push(line) });
  await restarted.review(USER, second.id, "approved");
  expect(r.pending()).toHaveLength(1);
  const body = r.pending()[0]!.body;
  expect(body).toContain("capacity_released: codex WIP 0");
  expect(body).toContain("capacity_released: pi WIP 0");
  expect(body).toContain(`backlog_ready: #${a.id}`);
  expect(body).toContain(`backlog_ready: #${b.id}`);
});
