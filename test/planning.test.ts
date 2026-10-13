import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { USER } from "../src/hub/envelope.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { planningPatch, actualTaskDates } from "../src/hub/planning.ts";
import { PreEffectToolRefusal } from "../src/hub/tool-refusal.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function rig() {
  const dir = mkdtempSync(join(tmpdir(), "ahub-planning-")), file = join(dir, "hub.db");
  const board = new Board(file), bus = new Bus({ batchMs: 0 });
  const tasks = new Tasks({ board, bus, routing: () => loadRouting(dir), cwd: dir, project: "planning", roles: { claude: ["planner"], codex: ["implementer"] }, notify: () => {} });
  cleanup.push(() => { bus.closeJournal(); board.close(); rmSync(dir, { recursive: true, force: true }); });
  return { file, board, tasks };
}

test("planning validates the whole patch and persists revision dates priority and release (#263)", async () => {
  const { board, tasks, file } = rig();
  const task = await tasks.propose(USER, { title: "future", class: "implement", backlog: true });
  const release = await tasks.newRelease(USER, { name: "next", goal: "Finish the board", order: 0 });
  expect(task.planningRevision).toBeUndefined();
  expect(task.plannedStart).toBeUndefined();
  await expect(tasks.planBacklog("codex", { id: task.id, revision: 0, fields: { priority: 1 }, reason: "needed" })).rejects.toThrow("planner role");
  for (const fields of [{ priority: 4 }, { due: "2026-10-12" }, { actualStart: 1 }, { pinned: 1 }, { release: 999 }, { plannedStart: 200, due: 100 }]) {
    await expect(tasks.planBacklog(USER, { id: task.id, revision: 0, fields, reason: "needed" })).rejects.toThrow();
    expect(board.get(task.id)?.planningRevision).toBeUndefined();
  }
  const planned = await tasks.planBacklog("claude", { id: task.id, revision: 0, fields: { rank: 10, priority: 1, release: release.id, plannedStart: 100, due: 200 }, reason: "Finish before ship" });
  expect(planned).toMatchObject({ planningRevision: 1, rank: 10, priority: 1, release: release.id, plannedStart: 100, due: 200 });
  const reopened = new Board(file);
  try { expect(reopened.get(task.id)).toEqual(planned); expect(reopened.release(release.id)).toEqual(release); } finally { reopened.close(); }
  await expect(tasks.planBacklog("claude", { id: task.id, revision: 0, fields: { priority: 0 }, reason: "stale" })).rejects.toThrow("revision");
});

test("planner cannot override pins person order or frozen scope and undo respects later edits (#263)", async () => {
  const { tasks, board } = rig();
  const task = await tasks.propose(USER, { title: "future", class: "implement", backlog: true });
  await tasks.planBacklog(USER, { id: task.id, revision: 0, fields: { rank: 1 }, reason: "person order" });
  await expect(tasks.planBacklog("claude", { id: task.id, revision: 1, fields: { rank: 0, priority: 0 }, reason: "urgent" })).rejects.toThrow("person's");
  await tasks.planBacklog("claude", { id: task.id, revision: 1, fields: { priority: 1 }, reason: "needed" });
  await tasks.planBacklog(USER, { id: task.id, revision: 2, fields: { pinned: true }, reason: "hold" });
  await expect(tasks.undoPlanning("claude", task.id, 2)).rejects.toThrow("stale");
  await expect(tasks.planBacklog("claude", { id: task.id, revision: 3, fields: { priority: 0 }, reason: "urgent" })).rejects.toThrow("unpinned");
  await tasks.undoPlanning(USER, task.id, 3);
  expect(board.get(task.id)?.pinned).toBeUndefined();
  const release = await tasks.newRelease(USER, { name: "frozen", goal: "Deliver", order: 0 });
  await tasks.planBacklog(USER, { id: task.id, revision: 4, fields: { release: release.id }, reason: "scope" });
  tasks.changeRelease(USER, { id: release.id, revision: 0, state: "active" });
  expect(() => tasks.changeRelease("claude", { id: release.id, revision: 1, state: "frozen" })).toThrow("person");
  tasks.changeRelease(USER, { id: release.id, revision: 1, state: "frozen" });
  await expect(tasks.planBacklog("claude", { id: task.id, revision: 5, fields: { release: null }, reason: "next release" })).rejects.toThrow("frozen");
  expect(() => tasks.changeRelease(USER, { id: release.id, revision: 2, state: "shipped" })).toThrow("approved");
  await tasks.planBacklog(USER, { id: task.id, revision: 5, fields: { release: null }, reason: "move out" });
  const shipped = tasks.changeRelease(USER, { id: release.id, revision: 2, state: "shipped" });
  expect(shipped.activatedAt).not.toBeNull(); expect(shipped.frozenAt).not.toBeNull(); expect(shipped.shippedAt).not.toBeNull();
  expect(() => tasks.changeRelease(USER, { id: release.id, revision: 3, state: "shipped" })).toThrow("final");
});

test("actual task dates use execution review and approval evidence rather than typed plans or notes (#263)", () => {
  const history = [{ at: 1, by: USER, event: "planned", note: "started at 0" }, { at: 10, by: "codex", event: "accepted" }, { at: 11, by: "codex", event: "done (checking)" }, { at: 20, by: "codex", event: "done" }, { at: 30, by: "claude", event: "changes_requested" }, { at: 40, by: "codex", event: "accepted" }, { at: 50, by: "codex", event: "done" }, { at: 60, by: "claude", event: "approved" }];
  expect(actualTaskDates({ history, state: "approved", reviewer: "claude" })).toEqual({ startedAt: 10, reviewAt: 20, doneAt: 60 });
  expect(actualTaskDates({ history: history.slice(0, 4), state: "in_review", reviewer: "claude" }).doneAt).toBeNull();
  expect(actualTaskDates({ history: history.slice(0, 4), state: "approved", reviewer: null })).toEqual({ startedAt: 10, reviewAt: null, doneAt: 20 });
  expect(actualTaskDates({ history: [], state: "backlog", reviewer: null })).toEqual({ startedAt: null, reviewAt: null, doneAt: null });
  expect(() => planningPatch({ startedAt: 1 })).toThrow("unknown");
});


test("planning dates refuse values outside UTC Date range before persistence (#263)", async () => {
  const { board, tasks } = rig();
  const task = await tasks.propose(USER, { title: "future", class: "implement", backlog: true });
  await expect(tasks.planBacklog(USER, { id: task.id, revision: 0, fields: { due: 8_640_000_000_000_001 }, reason: "bad date" })).rejects.toThrow("invalid planning field");
  expect(board.get(task.id)?.planningRevision).toBeUndefined();
  const release = await tasks.newRelease(USER, { name: "next", goal: "Deliver", order: 0 });
  expect(() => tasks.changeRelease(USER, { id: release.id, revision: 0, ship: 8_640_000_000_000_001 })).toThrow("invalid release planned dates");
  expect(board.release(release.id)?.revision).toBe(0);
});


test("planning persistence failures never claim a pre-effect refusal (#263)", async () => {
  const { board, tasks } = rig();
  const task = await tasks.propose(USER, { title: "future", class: "implement", backlog: true });
  const plan = board.plan.bind(board);
  board.plan = (...args) => { plan(...args); throw new Error("planning readback failed"); };
  const planningError = await tasks.planBacklog(USER, { id: task.id, revision: 0, fields: { priority: 1 }, reason: "needed" }).catch(error => error);
  expect(planningError).toBeInstanceOf(Error);
  expect(planningError).not.toBeInstanceOf(PreEffectToolRefusal);
  expect(board.get(task.id)?.planningRevision).toBe(1);
  const release = await tasks.newRelease(USER, { name: "next", goal: "Deliver", order: 0 });
  const change = board.updateRelease.bind(board);
  board.updateRelease = (...args) => { change(...args); throw new Error("release readback failed"); };
  let releaseError: unknown;
  try { tasks.changeRelease(USER, { id: release.id, revision: 0, state: "active" }); } catch (error) { releaseError = error; }
  expect(releaseError).toBeInstanceOf(Error);
  expect(releaseError).not.toBeInstanceOf(PreEffectToolRefusal);
  expect(board.release(release.id)?.state).toBe("active");
});


test("planner backlog reads follow saved rank with stable unknown order (#263)", async () => {
  const { tasks } = rig();
  const first = await tasks.propose(USER, { title: "first", class: "implement", backlog: true });
  const second = await tasks.propose(USER, { title: "second", class: "implement", backlog: true });
  const third = await tasks.propose(USER, { title: "third", class: "implement", backlog: true });
  await tasks.planBacklog(USER, { id: third.id, revision: 0, fields: { rank: 1 }, reason: "first phase" });
  await tasks.planBacklog(USER, { id: second.id, revision: 0, fields: { rank: 1 }, reason: "first phase" });
  expect(tasks.backlogList("claude").map(task => task.id)).toEqual([second.id, third.id, first.id]);
});


test("backlog planning validates dependency cycles reservations and atomic undo (#263)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-planning-graph-"));
  const board = new Board(join(dir, "hub.db")), bus = new Bus({ batchMs: 0, rostered: peer => ["claude", "codex"].includes(peer) });
  const tasks = new Tasks({ board, bus, routing: () => loadRouting(dir), cwd: dir, project: "planning", roles: { claude: ["planner"] }, notify: () => {} });
  cleanup.push(() => { bus.closeJournal(); board.close(); rmSync(dir, { recursive: true, force: true }); });
  const first = await tasks.propose(USER, { title: "first", class: "implement", backlog: true });
  const second = await tasks.propose(USER, { title: "second", class: "implement", backlog: true, after: [first.id] });
  const third = await tasks.propose(USER, { title: "third", class: "implement", backlog: true, after: [second.id] });
  for (const fields of [{ deps: [first.id] }, { deps: [third.id] }, { deps: [999] }, { deps: [second.id, second.id] }, { deps: [], reserved: "missing" }, { deps: null }, { deps: [1.5] }]) {
    await expect(tasks.planBacklog("claude", { id: first.id, revision: 0, fields, reason: "invalid graph" })).rejects.toThrow();
    expect(board.get(first.id)).toEqual(first);
  }
  const planned = await tasks.planBacklog("claude", { id: second.id, revision: 0, fields: { deps: [], reserved: "codex", priority: 1 }, reason: "ready prerequisite" });
  expect(planned).toMatchObject({ deps: [], reserved: "codex", priority: 1, planningRevision: 1, state: "backlog", owner: null });
  expect(tasks.publicView(planned, true)).not.toHaveProperty("history.1.planning.previous");
  const undone = await tasks.undoPlanning("claude", second.id, 1);
  expect(undone.deps).toEqual([first.id]);
  expect(undone.reserved).toBeNull();
  expect(undone.priority).toBeUndefined();
  await tasks.moveBacklog(USER, first.id, true);
  const executing = board.update(first.id, USER, "accepted", { state: "in_progress", owner: "codex" });
  await expect(tasks.planBacklog(USER, { id: first.id, revision: 0, fields: { deps: [] }, reason: "too late" })).rejects.toThrow("unstarted backlog");
  expect(board.get(first.id)).toEqual(executing);
});

test("planning normalizes real reservations and rejects unsupported pseudo peers before persistence (#263)", async () => {
  const {board,tasks}=rig();
  const task=await tasks.propose(USER,{title:"peer normalization",class:"implement",backlog:true});
  for(const reserved of ["user","hub","digest","not-registered","bad peer",{},123]) {
    const attempt=tasks.planBacklog("claude",{id:task.id,revision:0,fields:{reserved},reason:"invalid reservation"});
    await expect(attempt).rejects.toThrow();
    await expect(attempt).rejects.toBeInstanceOf(PreEffectToolRefusal);
    expect(board.get(task.id)).toEqual(task);
  }
  const planned=await tasks.planBacklog("claude",{id:task.id,revision:0,fields:{reserved:" Codex "},reason:"normalize owner"});
  expect(planned.reserved).toBe("codex");expect(planned.owner).toBeNull();
});

test("supported off-roster reservations are refused before any planning write",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"ahub-roster-planning-")),board=new Board(join(dir,"hub.db")),bus=new Bus({batchMs:0,rostered:peer=>peer!=="pi"});
 const tasks=new Tasks({board,bus,routing:()=>loadRouting(dir),cwd:dir,project:"roster-floor",roles:{claude:["planner"]},notify:()=>{}});cleanup.push(()=>{bus.closeJournal();board.close();rmSync(dir,{recursive:true,force:true})});
 const task=await tasks.propose(USER,{title:"native roster floor",class:"implement",backlog:true});
 for(const by of [USER,"claude"]){await expect(tasks.planBacklog(by,{id:task.id,revision:0,fields:{reserved:"pi"},reason:"ineligible native reservation"})).rejects.toThrow("off roster");expect(board.get(task.id)).toEqual(task)}
});

test("normalized reservation succeeds through the planning pipeline with a named outcome assertion", async () => {
 const {tasks}=rig(),task=await tasks.propose(USER,{title:"normalized pipeline outcome",class:"implement",backlog:true});
 const outcome=await tasks.planBacklog("claude",{id:task.id,revision:0,fields:{reserved:" Codex "},reason:"normalize configured owner"}).then(planned=>({reserved:planned.reserved,owner:planned.owner,state:planned.state}),()=>null);
 expect(outcome).toEqual({reserved:"codex",owner:null,state:"backlog"});
});
