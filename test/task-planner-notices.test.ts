import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { USER, type Envelope } from "../src/hub/envelope.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { assign, loadRouting } from "../src/hub/routing.ts";
import { sdlcConfig, type SdlcConfig } from "../src/hub/sdlc.ts";
import { DEFAULT_TASK_SWEEP } from "../src/hub/task-sweep.ts";

class NoticePeer extends BasePeer {
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(_envs: Envelope[]) {}
  busy() { this.setState("busy"); }
}
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function rig(config: SdlcConfig = sdlcConfig(undefined)) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-bound-planner-notices-")), board = new Board(join(dir, "hub.db"));
  const roles = { claude: ["planner"], codex: ["planner"], local: ["planner"], kimi: ["implementer"] }, routing = loadRouting(dir), told: { peer: string; body: string }[] = [];
  const bus: Bus = new Bus({ batchMs: 0, relevant: (peer, env) => tasks.relevant(peer, env) });
  const tasks = new Tasks({ board, bus, roles, cwd: dir, project: "fixture/planner-notices", routing: () => routing,
    notify: () => {}, tell: (peer, body) => { told.push({ peer, body }); }, wipLimit: () => 16,
    sweep: { ...DEFAULT_TASK_SWEEP, enabled: true, ready_min: 1, unaccepted_min: 1, idle_min: 1, review_min: 1, ladder_min: 1 },
    sdlc: { config: () => config, gh: async () => { throw new Error("fixture must never read GitHub"); } } });
  const peers = Object.fromEntries(await Promise.all(Object.keys(roles).map(async id => { const peer = new NoticePeer(id, 60_000); bus.add(peer); await peer.start(); if (id !== "kimi") peer.busy(); return [id, peer] as const; })));
  cleanup.push(async () => { for (const peer of Object.values(peers)) await peer.stop(); bus.closeJournal(); board.close(); rmSync(dir, { recursive: true, force: true }); });
  const backlog = async (planner: string | null, title = "PRIVATE_TITLE_NOT_IN_IDS_NOTICE") => {
    const made = await tasks.propose(USER, { title, class: "implement", backlog: true });
    return board.update(made.id, USER, "fixture planner", { planner });
  };
  return { tasks, board, bus, roles, routing, told, peers, backlog };
}
const batches = (r: Awaited<ReturnType<typeof rig>>, peer: string) => r.bus.pendingEnvelopes(peer).filter(env => !!env.refs?.backlog);
const ids = (r: Awaited<ReturnType<typeof rig>>, peer: string) => batches(r, peer).flatMap(env => env.refs!.backlog!);

test("backlog batches contain only effective planner ids, while legacy null rows reach each holder", async () => {
  const r = await rig(), a = await r.backlog("claude"), b = await r.backlog("codex"), legacy = await r.backlog(null);
  r.tasks.flushPlannerNotices(); r.tasks.flushPlannerNotices();
  expect(ids(r, "claude")).toEqual([a.id, legacy.id]);
  expect(ids(r, "codex")).toEqual([b.id, legacy.id]);
  expect(ids(r, "local")).toEqual([legacy.id]);
  for (const peer of ["claude", "codex", "local"]) {
    expect(batches(r, peer)).toHaveLength(1);
    expect(batches(r, peer)[0]!.body).not.toContain("PRIVATE_TITLE_NOT_IN_IDS_NOTICE");
  }
});

test("a queued backlog batch whose binding moves is withdrawn, restaged to the new planner and not duplicated", async () => {
  const r = await rig(), task = await r.backlog("claude"); r.tasks.flushPlannerNotices();
  const old = batches(r, "claude")[0]!; expect(old.refs?.backlog).toEqual([task.id]);
  r.board.update(task.id, USER, "fixture planner changed", { planner: "codex" });
  expect(r.tasks.relevant("claude", old)).toBe(false);
  expect(r.bus.pull("claude")?.filter(env => !!env.refs?.backlog)).toEqual([]);
  r.tasks.flushPlannerNotices(); r.tasks.flushPlannerNotices();
  expect(ids(r, "claude")).toEqual([]); expect(ids(r, "codex")).toEqual([task.id]); expect(batches(r, "codex")).toHaveLength(1);
  expect(r.bus.pull("codex")?.filter(env => !!env.refs?.backlog).map(env => env.refs!.backlog)).toEqual([[task.id]]);
  expect(ids(r, "codex")).toEqual([]);
});

test("ready-unassigned sweep and no-owner stall notices go only to the effective planner", async () => {
  const r = await rig(), made = r.board.propose(USER, { title: "ready fixture", class: "implement" });
  const task = r.board.update(made.id, USER, "fixture planner", { planner: "claude" });
  expect(await r.tasks.sweep(task.updated + 60_000)).toMatchObject([{ task: task.id, finding: { kind: "ready-unassigned", step: 1 } }]);
  const sweep = (peer: string) => r.bus.pendingEnvelopes(peer).filter(env => env.refs?.task === String(task.id) && env.refs.taskRecipient === "planner");
  expect(sweep("claude")).toHaveLength(1); expect(sweep("codex")).toEqual([]); expect(sweep("local")).toEqual([]);
  const bound = sweep("claude")[0]!; r.board.update(task.id, USER, "fixture reassigned planner", { planner: "codex" });
  expect(r.tasks.relevant("claude", bound)).toBe(false);
  for (const peer of Object.values(r.peers)) await peer.stop();
  const stalled = await r.tasks.propose(USER, { title: "no execution owner", class: "implement" });
  expect(stalled.owner).toBeNull(); expect(stalled.planner).toBeDefined();
  expect(r.told.map(row => row.peer)).toEqual([stalled.planner]);
});

test("independent review notices use pure rotation, expose ids only and remain current across equal-clock plan revisions", async () => {
  const now = Date.now; Date.now = () => 100_000;
  try {
    const r = await rig(sdlcConfig({ mode: "enforce", required_checks: [] }));
    const made = r.board.propose("claude", { title: "PRIVATE_TITLE_NOT_IN_REVIEW_NOTICE", class: "implement", backlog: true, plan: { paths: ["private-plan-marker.ts"] } });
    const task = r.board.update(made.id, USER, "fixture bound author", { planner: "claude" });
    const expected = assign({ ...task, state: "proposed" }, { claude: "busy", codex: "busy", local: "busy", kimi: "idle" }, r.routing,
      { roles: r.roles, candidates: [], planners: ["codex", "local"] }).planner!;
    await expect(r.tasks.pullPlanned("claude", { id: task.id, revision: 0, reason: "needs independent review" })).rejects.toThrow("plan");
    await expect(r.tasks.pullPlanned("claude", { id: task.id, revision: 0, reason: "same request" })).rejects.toThrow("plan");
    const requests = () => r.bus.pendingEnvelopes(expected).filter(env => env.refs?.planReview !== undefined);
    expect(requests()).toHaveLength(1); const first = requests()[0]!;
    expect(first.to).toEqual([expected]); expect(first.refs).toMatchObject({ task: String(task.id), planReview: 0, planAuthor: "claude" });
    expect(first.body).not.toContain("PRIVATE_TITLE_NOT_IN_REVIEW_NOTICE"); expect(first.body).not.toContain("private-plan-marker");
    expect(r.tasks.relevant(expected, first)).toBe(true);
    await r.tasks.recordPlanReview(expected, task.id, { revision: 0, reason: "independent", review: { scope: "full", reviewers: 1 }, ci: "full" });
    expect(r.tasks.relevant(expected, first)).toBe(false);
    await r.tasks.planBacklog("claude", { id: task.id, revision: 0, fields: { priority: 1 }, reason: "new planning revision" });
    await expect(r.tasks.pullPlanned("claude", { id: task.id, revision: 1, reason: "new review required" })).rejects.toThrow("plan");
    const current = requests().find(env => env.refs?.planReview === 1)!; expect(current).toBeDefined();
    // Date.now is deliberately unchanged: flow evidence, not a strict millisecond comparison, distinguishes reviews.
    expect(current.ts).toBe(first.ts); expect(r.tasks.relevant(expected, current)).toBe(true);
    await r.tasks.recordPlanReview(expected, task.id, { revision: 1, reason: "review revised plan", review: { scope: "full", reviewers: 1 }, ci: "full" });
    expect(r.tasks.relevant(expected, current)).toBe(false);
  } finally { Date.now = now; }
});

test("bound planner lifecycle actors may record only stage identity, never reviewer or deliverable authority", async () => {
  const config = sdlcConfig({ mode: "enforce", required_checks: [], stages: ["question", "draft", "review"], definitions: {
    question: { base: "plan", actor: "planner", entry_gates: [], exit_gates: [] },
    draft: { base: "plan", actor: "owner/planner", entry_gates: [], exit_gates: [] },
    review: { base: "review", actor: "reviewer", entry_gates: [], exit_gates: [] },
  } });
  const r = await rig(config), made = r.board.propose(USER, { title: "stage fixture", class: "implement" });
  const task = r.board.update(made.id, USER, "fixture execution", { owner: "kimi", reviewer: "local", planner: "claude" });
  expect(r.tasks.recordLifecycle("claude", task.id, { stage: "question" }).sdlc?.stage).toBe("question");
  expect(r.tasks.recordLifecycle("claude", task.id, { stage: "draft" }).sdlc?.stage).toBe("draft");
  const before = r.board.get(task.id);
  for (const input of [{ stage: "question", reviewedHead: "a".repeat(40) }, { stage: "question", criteria: { id: "checklist", criteria: [] } }, { stage: "review" }]) {
    expect(() => r.tasks.recordLifecycle("claude", task.id, input)).toThrow(); expect(r.board.get(task.id)).toEqual(before);
  }
  await expect(r.tasks.recordSdlc("claude", task.id, { stage: "question", deliverables: [] })).rejects.toThrow(); expect(r.board.get(task.id)).toEqual(before);
  const other = r.board.update(r.board.propose(USER, { title: "another planner's task", class: "implement" }).id, USER, "fixture other planner", { owner: "kimi", reviewer: "local", planner: "codex" });
  expect(() => r.tasks.recordLifecycle("claude", other.id, { stage: "question" })).toThrow(); expect(r.board.get(other.id)).toEqual(other);
});
